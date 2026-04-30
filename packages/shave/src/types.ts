// @decision DEC-CONTINUOUS-SHAVE-022: The shave package exposes three public
// entry points — shave() for one-shot file processing, universalize() for
// continuous single-block processing, and IntentExtractionHook for hookable
// pipeline extensions. All three operate over the same registry view interface
// so callers can substitute any registry implementation without coupling to
// the SQLite storage layer.
// Status: decided (MASTER_PLAN.md DEC-CONTINUOUS-SHAVE-022)
// Rationale: Separating the registry view from the full Registry interface
// keeps shave testable with lightweight noop stubs and decoupled from storage.

import type { BlockMerkleRoot, CanonicalAstHash, SpecHash } from "@yakcc/contracts";
import type { BlockTripletRow } from "@yakcc/registry";
import type { IntentCard } from "./intent/types.js";
import type { SlicePlanEntry } from "./universalize/types.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Configuration options passed to shave() and universalize().
 * All fields are optional; defaults are documented on each field.
 */
export interface ShaveOptions {
  /**
   * Directory for the file-system intent-extraction cache.
   * Defaults to os.tmpdir()/yakcc-shave-cache when not specified.
   * WI-010-02 fills the cache implementation.
   */
  readonly cacheDir?: string | undefined;
  /**
   * The Anthropic model identifier to use for intent extraction.
   * Defaults to "claude-3-5-haiku-20241022".
   * WI-010-02 connects this to the Anthropic SDK.
   */
  readonly model?: string | undefined;
  /**
   * When true, skip live extraction and rely entirely on cache hits.
   * Useful for CI environments without API access.
   */
  readonly offline?: boolean | undefined;
  /**
   * Tuning options forwarded to decompose() for the AST recursion.
   * maxDepth (default 8) and maxControlFlowBoundaries (default 1) control
   * when the recursion stops and what counts as atomic. WI-012-06.
   */
  readonly recursionOptions?:
    | {
        readonly maxDepth?: number;
        readonly maxControlFlowBoundaries?: number;
      }
    | undefined;
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * Diagnostic information returned alongside every shave/universalize result.
 *
 * `stubbed` lists capabilities that are not yet implemented in this work item:
 *   - "decomposition": atom decomposition is a stub (WI-010-01)
 *   - "variance": variance scoring is a stub (WI-011)
 *   - "license-gate": license gating is a stub (future WI)
 *
 * `cacheHits` and `cacheMisses` count intent-extraction cache events.
 * Both will be 0 in WI-010-01 stubs; WI-010-02 populates them.
 */
export interface ShaveDiagnostics {
  readonly stubbed: readonly ("decomposition" | "variance" | "license-gate")[];
  readonly cacheHits: number;
  readonly cacheMisses: number;
}

// ---------------------------------------------------------------------------
// Shave result types
// ---------------------------------------------------------------------------

/**
 * A stub placeholder for a decomposed atom within a source file.
 *
 * WI-012 replaces this with a real atom backed by a content-addressed
 * block in the registry. In WI-010-01 the atoms array is always empty.
 */
export interface ShavedAtomStub {
  /** A generated placeholder identifier for this atom position. */
  readonly placeholderId: string;
  /** Byte range within the source file that this atom covers. */
  readonly sourceRange: { readonly start: number; readonly end: number };
}

/**
 * The result of a shave() call on a single source file.
 *
 * In WI-010-01 all arrays are empty stubs. WI-010-02 populates intentCards
 * via the real extractIntent path; WI-012 populates atoms via the DFG slicer.
 */
export interface ShaveResult {
  /** Absolute path of the source file that was processed. */
  readonly sourcePath: string;
  /** Decomposed atom stubs — empty until WI-012. */
  readonly atoms: readonly ShavedAtomStub[];
  /** Extracted intent cards — empty until WI-010-02. */
  readonly intentCards: readonly IntentCard[];
  /** Diagnostic information about the processing run. */
  readonly diagnostics: ShaveDiagnostics;
}

// ---------------------------------------------------------------------------
// Universalize result types
// ---------------------------------------------------------------------------

/**
 * One entry in the slice plan produced by universalize().
 *
 * WI-012-06 wires universalize() to the real DFG slicer. This is a type alias
 * for SlicePlanEntry (PointerEntry | NovelGlueEntry), keeping the public
 * surface aligned with the slicer's discriminated union while letting callers
 * import UniversalizeSlicePlanEntry from the top-level types path.
 *
 * @decision DEC-UNIVERSALIZE-WIRING-001
 * title: UniversalizeSlicePlanEntry aliased to SlicePlanEntry
 * status: decided
 * rationale: The WI-010-01 placeholder shape ({ placeholderId, sourceRange })
 * was superseded by the slicer's PointerEntry | NovelGlueEntry discriminated
 * union (WI-012-05). Re-exporting SlicePlanEntry as UniversalizeSlicePlanEntry
 * avoids two parallel types describing the same thing and keeps the public API
 * surface stable without requiring callers to import from the sub-module path.
 */
export type UniversalizeSlicePlanEntry = SlicePlanEntry;

/**
 * The result of a universalize() call on a single candidate block.
 *
 * The intentCard is the primary output — it describes the behavioral intent
 * of the candidate. slicePlan is populated by WI-012-06 via the real DFG
 * slicer. matchedPrimitives carries the deduplicated (canonicalAstHash,
 * merkleRoot) pairs from the slicer. Variance-based matching (WI-011) is
 * still stubbed and listed in diagnostics.stubbed.
 */
export interface UniversalizeResult {
  /** The extracted intent card for this candidate. */
  readonly intentCard: IntentCard;
  /** DFG-based slice plan — live as of WI-012-06. */
  readonly slicePlan: readonly SlicePlanEntry[];
  /**
   * Registry primitives matched by canonical AST hash — populated by WI-012-06.
   * Each entry carries (canonicalAstHash, merkleRoot) from the slicer's
   * PointerEntry nodes. Variance-scored matches (specHash) are WI-011.
   */
  readonly matchedPrimitives: readonly {
    readonly canonicalAstHash: CanonicalAstHash;
    readonly merkleRoot: BlockMerkleRoot;
  }[];
  readonly diagnostics: ShaveDiagnostics;
}

// ---------------------------------------------------------------------------
// Candidate block
// ---------------------------------------------------------------------------

/**
 * A candidate block submitted for universalization.
 *
 * `source` is the raw source text. `hint` carries optional metadata that
 * hooks or callers may supply to improve extraction quality — it is never
 * required for correctness.
 */
export interface CandidateBlock {
  readonly source: string;
  readonly hint?:
    | {
        readonly name?: string | undefined;
        readonly origin?: "user" | "ai-hook" | "compile-resolver" | undefined;
      }
    | undefined;
}

// ---------------------------------------------------------------------------
// Registry view — narrow read-only interface for shave operations
// ---------------------------------------------------------------------------

/**
 * The minimal read interface that shave() and universalize() require from the
 * registry. This is intentionally narrower than @yakcc/registry's full Registry
 * interface to keep the shave package decoupled from the SQLite storage layer.
 *
 * findByCanonicalAstHash is optional: shave uses it for structural deduplication
 * when available but degrades gracefully to spec-hash-only lookup otherwise.
 */
export interface ShaveRegistryView {
  selectBlocks(specHash: SpecHash): Promise<readonly BlockMerkleRoot[]>;
  getBlock(merkleRoot: BlockMerkleRoot): Promise<BlockTripletRow | undefined>;
  findByCanonicalAstHash?(canonicalAstHash: string): Promise<readonly BlockMerkleRoot[]>;
}

// ---------------------------------------------------------------------------
// Intent extraction hook interface
// ---------------------------------------------------------------------------

/**
 * A hookable extension point for the intent-extraction pipeline.
 *
 * Hooks intercept CandidateBlock instances before the default Anthropic
 * extractor runs. A hook may return a fully-populated UniversalizeResult
 * (short-circuiting the default extractor) or may mutate the candidate and
 * pass it on.
 *
 * DEC-CONTINUOUS-SHAVE-022: hooks participate in the continuous universalizer
 * loop so that third-party packages can inject specialized extractors (e.g.
 * for specific DSLs or test frameworks) without forking the shave package.
 */
export interface IntentExtractionHook {
  /** Unique identifier for this hook, e.g. "yakcc.shave.default". */
  readonly id: string;
  intercept(
    candidate: CandidateBlock,
    registry: ShaveRegistryView,
    options?: ShaveOptions,
  ): Promise<UniversalizeResult>;
}
